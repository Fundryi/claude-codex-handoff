const BRAND_BLUE: [u8; 3] = [23, 99, 246];
const BRAND_CYAN: [u8; 3] = [0, 217, 218];

pub fn render_brand_icon(size: u32) -> Vec<u8> {
    render_icon(size, |x, _| mix(BRAND_BLUE, BRAND_CYAN, x))
}

pub fn render_status_icon(size: u32, color: [u8; 3]) -> Vec<u8> {
    render_icon(size, |x, _| {
        let brightness = 0.9 + x * 0.2;
        color.map(|channel| ((channel as f32 * brightness).min(255.0)) as u8)
    })
}

fn render_icon(size: u32, color_at: impl Fn(f32, f32) -> [u8; 3]) -> Vec<u8> {
    const SAMPLES: u32 = 4;
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);

    for y in 0..size {
        for x in 0..size {
            let mut channels = [0_u32; 4];

            for sample_y in 0..SAMPLES {
                for sample_x in 0..SAMPLES {
                    let px = (x as f32 + (sample_x as f32 + 0.5) / SAMPLES as f32) / size as f32;
                    let py = (y as f32 + (sample_y as f32 + 0.5) / SAMPLES as f32) / size as f32;
                    if !inside_logo(px, py) {
                        continue;
                    }

                    let color = color_at(px, py);
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

fn inside_logo(x: f32, y: f32) -> bool {
    let point = [x, y];
    let chevron_width = 0.084 / 2.0;
    let center_width = 0.072 / 2.0;
    let segments = [
        ([0.33, 0.26], [0.12, 0.50], chevron_width),
        ([0.12, 0.50], [0.33, 0.74], chevron_width),
        ([0.67, 0.26], [0.88, 0.50], chevron_width),
        ([0.88, 0.50], [0.67, 0.74], chevron_width),
        ([0.50, 0.13], [0.50, 0.35], center_width),
        ([0.50, 0.35], [0.41, 0.44], center_width),
        ([0.41, 0.44], [0.463, 0.493], center_width),
        ([0.538, 0.526], [0.59, 0.585], center_width),
        ([0.59, 0.585], [0.50, 0.68], center_width),
        ([0.50, 0.68], [0.50, 0.87], center_width),
    ];

    if segments
        .iter()
        .any(|(start, end, width)| distance_to_segment(point, *start, *end) <= *width)
    {
        return true;
    }

    let dx = x - 0.5;
    let dy = y - 0.5;
    let radius = (dx * dx + dy * dy).sqrt();
    (0.043..=0.097).contains(&radius)
}

fn distance_to_segment(point: [f32; 2], start: [f32; 2], end: [f32; 2]) -> f32 {
    let segment = [end[0] - start[0], end[1] - start[1]];
    let relative = [point[0] - start[0], point[1] - start[1]];
    let length_squared = segment[0] * segment[0] + segment[1] * segment[1];
    let projection =
        ((relative[0] * segment[0] + relative[1] * segment[1]) / length_squared).clamp(0.0, 1.0);
    let closest = [
        start[0] + segment[0] * projection,
        start[1] + segment[1] * projection,
    ];
    let dx = point[0] - closest[0];
    let dy = point[1] - closest[1];
    (dx * dx + dy * dy).sqrt()
}

fn mix(left: [u8; 3], right: [u8; 3], amount: f32) -> [u8; 3] {
    std::array::from_fn(|index| {
        (left[index] as f32 * (1.0 - amount) + right[index] as f32 * amount) as u8
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_expected_rgba_dimensions() {
        assert_eq!(render_brand_icon(32).len(), 32 * 32 * 4);
        assert_eq!(render_status_icon(32, [248, 81, 73]).len(), 32 * 32 * 4);
    }

    #[test]
    fn keeps_background_transparent() {
        let icon = render_brand_icon(32);
        assert_eq!(icon[3], 0);
        assert!(icon.chunks_exact(4).any(|pixel| pixel[3] > 0));
    }
}
