use base64::{engine::general_purpose::STANDARD, Engine as _};
use resvg::usvg::{Options, Tree};
use serde::{Deserialize, Serialize};
use std::alloc::{alloc, dealloc, Layout};

const MAX_INPUT_BYTES: usize = 1_048_576;
const MAX_OUTPUT_BYTES: usize = 4_194_304;
const MAX_PNG_BYTES: usize = 2_900_000;
const MAX_DIMENSION: u32 = 4_096;
const MAX_PIXELS: u64 = 16_777_216;

#[derive(Deserialize)]
struct Request {
    svg: String,
}

#[derive(Serialize)]
struct Success {
    ok: bool,
    png: String,
    width: u32,
    height: u32,
}

#[derive(Serialize)]
struct Failure {
    ok: bool,
    error: String,
}

fn encode_result<T: Serialize>(result: T) -> u64 {
    let bytes = serde_json::to_vec(&result).unwrap_or_else(|_| b"{\"ok\":false,\"error\":\"Could not encode adapter result.\"}".to_vec());
    let layout = match Layout::from_size_align(bytes.len().max(1), 8) {
        Ok(value) => value,
        Err(_) => return 0,
    };
    let pointer = unsafe { alloc(layout) };
    if pointer.is_null() || bytes.len() > u32::MAX as usize {
        return 0;
    }
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), pointer, bytes.len()) };
    ((pointer as u32 as u64) << 32) | bytes.len() as u64
}

#[no_mangle]
pub extern "C" fn arc_alloc(length: u32) -> u32 {
    if length == 0 || length as usize > MAX_INPUT_BYTES + 64 {
        return 0;
    }
    let layout = match Layout::from_size_align(length as usize, 8) {
        Ok(value) => value,
        Err(_) => return 0,
    };
    unsafe { alloc(layout) as u32 }
}

#[no_mangle]
pub extern "C" fn arc_free(pointer: u32, length: u32) {
    if pointer == 0 || length == 0 || length as usize > MAX_INPUT_BYTES + MAX_OUTPUT_BYTES {
        return;
    }
    if let Ok(layout) = Layout::from_size_align(length as usize, 8) {
        unsafe { dealloc(pointer as *mut u8, layout) };
    }
}

#[no_mangle]
pub extern "C" fn arc_run(pointer: u32, length: u32) -> u64 {
    if pointer == 0 || length == 0 || length as usize > MAX_INPUT_BYTES {
        return encode_result(Failure { ok: false, error: "SVG input is empty or exceeds 1 MiB.".into() });
    }

    let input = unsafe { std::slice::from_raw_parts(pointer as *const u8, length as usize) };
    let request: Request = match serde_json::from_slice(input) {
        Ok(value) => value,
        Err(_) => return encode_result(Failure { ok: false, error: "Input must be JSON with an svg string.".into() }),
    };
    if request.svg.len() > MAX_INPUT_BYTES {
        return encode_result(Failure { ok: false, error: "SVG input exceeds 1 MiB.".into() });
    }

    let tree = match Tree::from_str(&request.svg, &Options::default()) {
        Ok(value) => value,
        Err(_) => return encode_result(Failure { ok: false, error: "SVG could not be parsed.".into() }),
    };
    let size = tree.size().to_int_size();
    let width = size.width();
    let height = size.height();
    if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION || (width as u64 * height as u64) > MAX_PIXELS {
        return encode_result(Failure { ok: false, error: "SVG dimensions exceed the 4096 px or 16 megapixel limit.".into() });
    }

    let Some(mut pixmap) = resvg::tiny_skia::Pixmap::new(width, height) else {
        return encode_result(Failure { ok: false, error: "Could not allocate the PNG surface.".into() });
    };
    resvg::render(&tree, resvg::tiny_skia::Transform::default(), &mut pixmap.as_mut());
    let png = match pixmap.encode_png() {
        Ok(value) => value,
        Err(_) => return encode_result(Failure { ok: false, error: "PNG encoding failed.".into() }),
    };
    if png.len() > MAX_PNG_BYTES {
        return encode_result(Failure { ok: false, error: "Rendered PNG exceeds 2.9 MB.".into() });
    }

    encode_result(Success { ok: true, png: format!("data:image/png;base64,{}", STANDARD.encode(png)), width, height })
}
