const DARK_MARK: [u8; 3] = [8, 17, 31];

pub fn render_icon(size: u32, accent: [u8; 3]) -> Vec<u8> {
    const SAMPLES: u32 = 4;
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);

    for y in 0..size {
        for x in 0..size {
            let mut channels = [0_u32; 4];

            for sample_y in 0..SAMPLES {
                for sample_x in 0..SAMPLES {
                    let px = (x as f32 + (sample_x as f32 + 0.5) / SAMPLES as f32) / size as f32;
                    let py = (y as f32 + (sample_y as f32 + 0.5) / SAMPLES as f32) / size as f32;
                    let Some(color) = sample_color(px, py, accent) else {
                        continue;
                    };

                    channels[0] += color[0] as u32;
                    channels[1] += color[1] as u32;
                    channels[2] += color[2] as u32;
                    channels[3] += 255;
                }
            }

            let sample_count = SAMPLES * SAMPLES;
            rgba.extend(channels.map(|channel| (channel / sample_count) as u8));
        }
    }

    rgba
}

fn sample_color(x: f32, y: f32, accent: [u8; 3]) -> Option<[u8; 3]> {
    if !inside_rounded_square(x, y) {
        return None;
    }

    let dx = x - 0.5;
    let dy = y - 0.5;
    let radius = (dx * dx + dy * dy).sqrt();
    let inside_c = (0.18..=0.32).contains(&radius) && !(dx > 0.0 && dy.abs() < dx);
    if inside_c {
        return Some(DARK_MARK);
    }

    let brightness = 1.18 - y * 0.32;
    Some(accent.map(|channel| ((channel as f32 * brightness).min(255.0)) as u8))
}

fn inside_rounded_square(x: f32, y: f32) -> bool {
    const MARGIN: f32 = 0.035;
    const RADIUS: f32 = 0.22;
    let nearest_x = x.clamp(MARGIN + RADIUS, 1.0 - MARGIN - RADIUS);
    let nearest_y = y.clamp(MARGIN + RADIUS, 1.0 - MARGIN - RADIUS);
    let dx = x - nearest_x;
    let dy = y - nearest_y;
    dx * dx + dy * dy <= RADIUS * RADIUS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_expected_rgba_dimensions() {
        assert_eq!(render_icon(32, [88, 166, 255]).len(), 32 * 32 * 4);
    }
}
