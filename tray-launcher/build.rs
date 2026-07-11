mod icon_art;

use std::{env, fs, path::Path};

const ICON_SIZES: [u32; 8] = [16, 20, 24, 32, 40, 48, 64, 256];
const BRAND_BLUE: [u8; 3] = [88, 166, 255];

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=icon_art.rs");

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let output_dir = env::var_os("OUT_DIR").expect("Cargo provides OUT_DIR");
    let icon_path = Path::new(&output_dir).join("codex-live-viewer.ico");
    fs::write(&icon_path, build_ico()).expect("write generated Windows icon");

    let mut resource = winresource::WindowsResource::new();
    resource.set_icon(icon_path.to_str().expect("icon path is valid UTF-8"));
    resource.set("FileDescription", "Codex Live Viewer");
    resource.set("ProductName", "Codex Live Viewer");
    resource.set("OriginalFilename", "Codex Live Viewer.exe");
    resource.compile().expect("embed Windows icon resource");
}

fn build_ico() -> Vec<u8> {
    let images: Vec<Vec<u8>> = ICON_SIZES
        .iter()
        .map(|size| dib_image(*size, &icon_art::render_icon(*size, BRAND_BLUE)))
        .collect();
    let directory_size = 6 + images.len() * 16;
    let mut output =
        Vec::with_capacity(directory_size + images.iter().map(Vec::len).sum::<usize>());

    output.extend_from_slice(&0_u16.to_le_bytes());
    output.extend_from_slice(&1_u16.to_le_bytes());
    output.extend_from_slice(&(images.len() as u16).to_le_bytes());

    let mut offset = directory_size as u32;
    for (size, image) in ICON_SIZES.iter().zip(&images) {
        output.push(if *size == 256 { 0 } else { *size as u8 });
        output.push(if *size == 256 { 0 } else { *size as u8 });
        output.push(0);
        output.push(0);
        output.extend_from_slice(&1_u16.to_le_bytes());
        output.extend_from_slice(&32_u16.to_le_bytes());
        output.extend_from_slice(&(image.len() as u32).to_le_bytes());
        output.extend_from_slice(&offset.to_le_bytes());
        offset += image.len() as u32;
    }

    for image in images {
        output.extend_from_slice(&image);
    }
    output
}

fn dib_image(size: u32, rgba: &[u8]) -> Vec<u8> {
    let mask_stride = size.div_ceil(32) * 4;
    let pixel_bytes = size * size * 4;
    let mask_bytes = mask_stride * size;
    let mut dib = Vec::with_capacity((40 + pixel_bytes + mask_bytes) as usize);

    dib.extend_from_slice(&40_u32.to_le_bytes());
    dib.extend_from_slice(&(size as i32).to_le_bytes());
    dib.extend_from_slice(&((size * 2) as i32).to_le_bytes());
    dib.extend_from_slice(&1_u16.to_le_bytes());
    dib.extend_from_slice(&32_u16.to_le_bytes());
    dib.extend_from_slice(&0_u32.to_le_bytes());
    dib.extend_from_slice(&pixel_bytes.to_le_bytes());
    dib.extend_from_slice(&0_i32.to_le_bytes());
    dib.extend_from_slice(&0_i32.to_le_bytes());
    dib.extend_from_slice(&0_u32.to_le_bytes());
    dib.extend_from_slice(&0_u32.to_le_bytes());

    for y in (0..size).rev() {
        for x in 0..size {
            let index = ((y * size + x) * 4) as usize;
            dib.extend_from_slice(&[
                rgba[index + 2],
                rgba[index + 1],
                rgba[index],
                rgba[index + 3],
            ]);
        }
    }
    dib.resize((40 + pixel_bytes + mask_bytes) as usize, 0);
    dib
}
