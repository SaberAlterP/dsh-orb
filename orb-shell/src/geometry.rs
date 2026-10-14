//! Floating-ball window geometry, ported line by line from DeepSeek Orb 0.1.7 `lib/main.js`
//! (`collapsedWindowBounds`, `expandDirection`, `moveFloatingBall`, `clampFloatingWindow`, `snapToEdge`,
//! `unsnapDockedBall`, `setFloatingExpanded`, ...). Units are Chromium screen DIPs, the same units the
//! floating renderer's `event.screenX/Y` use, so Orb's constants apply unchanged.

use serde::Serialize;

pub const BALL: f64 = 72.0;
pub const PANEL_W: f64 = 320.0;
pub const PANEL_H: f64 = 420.0;
pub const PANEL_WINDOW_W: f64 = PANEL_W + 24.0;
pub const PANEL_WINDOW_H: f64 = PANEL_H + 24.0;
pub const BALL_DEFAULT_BELOW_CENTER: f64 = 0.08;
/// `Math.round(72 / 5)` and `Math.round(72 / 3)` in Orb.
pub const DOCK_OVERLAP: f64 = 14.0;
pub const DOCK_DRAG_OFF: f64 = 24.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct Display {
    pub bounds: Rect,
    pub work_area: Rect,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Horizontal {
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Vertical {
    Up,
    Down,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Direction {
    pub horizontal: Horizontal,
    pub vertical: Vertical,
}

#[derive(Clone, Copy, Debug)]
pub struct Dock {
    pub side: Side,
    pub y: f64,
}

/// `{ docked }` replies of Orb's move/clamp/unsnap handlers.
#[derive(Serialize)]
pub struct Docked {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docked: Option<Side>,
}

/// `expandState(expanded, direction, docked)`.
#[derive(Serialize)]
pub struct ExpandState {
    pub expanded: bool,
    pub horizontal: Horizontal,
    pub vertical: Vertical,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub docked: Option<Side>,
}

pub fn round(v: f64) -> f64 {
    // JavaScript Math.round: halves round toward +infinity.
    (v + 0.5).floor()
}

pub fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max.max(min))
}

pub fn is_collapsed(bounds: Rect) -> bool {
    bounds.width <= 96.0 && bounds.height <= 96.0
}

pub fn collapsed_window_bounds(ball: Point) -> Rect {
    Rect { x: ball.x - 12.0, y: ball.y - 12.0, width: 96.0, height: 96.0 }
}

pub fn clamp_window_origin(value: f64, work_origin: f64, work_size: f64, window_size: f64) -> f64 {
    clamp(value, work_origin - 12.0, work_origin + work_size - window_size + 12.0)
}

pub fn dock_side_for_ball_origin(ball: Point, bounds: Rect) -> Option<Side> {
    let left_overlap = bounds.x - ball.x;
    let right_overlap = ball.x + BALL - (bounds.x + bounds.width);
    if left_overlap >= DOCK_OVERLAP && left_overlap >= right_overlap {
        return Some(Side::Left);
    }
    if right_overlap >= DOCK_OVERLAP {
        return Some(Side::Right);
    }
    None
}

pub fn docked_tab_bounds(side: Side, ball_y: f64, bounds: Rect) -> Rect {
    let y = clamp(round(ball_y - 8.0), bounds.y, bounds.y + bounds.height - 88.0);
    Rect {
        x: if side == Side::Left { bounds.x } else { bounds.x + bounds.width - 34.0 },
        y,
        width: 34.0,
        height: 88.0,
    }
}

pub fn clamp_ball_y(ball_y: f64, bounds: Rect) -> f64 {
    clamp(round(ball_y), bounds.y, bounds.y + bounds.height - BALL)
}

pub fn off_screen_ball_origin(side: Side, ball_y: f64, bounds: Rect) -> Point {
    let y = clamp_ball_y(ball_y, bounds);
    Point {
        x: if side == Side::Left { bounds.x - BALL - 2.0 } else { bounds.x + bounds.width + 2.0 },
        y,
    }
}

pub fn inside_ball_origin(side: Side, ball_y: f64, display: &Display) -> Point {
    Point {
        x: if side == Side::Left { display.bounds.x + 5.0 } else { display.bounds.x + display.bounds.width - BALL - 5.0 },
        y: clamp(round(ball_y), display.work_area.y, display.work_area.y + display.work_area.height - BALL),
    }
}

pub fn stays_docked(side: Side, cursor_x: f64, bounds: Rect) -> bool {
    match side {
        Side::Right => cursor_x >= bounds.x + bounds.width - DOCK_DRAG_OFF,
        Side::Left => cursor_x <= bounds.x + DOCK_DRAG_OFF,
    }
}

pub fn ease_in_out_cubic(t: f64) -> f64 {
    if t < 0.5 {
        4.0 * t * t * t
    } else {
        1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
    }
}

pub fn ease_out_cubic(t: f64) -> f64 {
    1.0 - (1.0 - t).powi(3)
}

pub fn lerp_rect(start: Rect, end: Rect, t: f64) -> Rect {
    Rect {
        x: round(start.x + (end.x - start.x) * t),
        y: round(start.y + (end.y - start.y) * t),
        width: round(start.width + (end.width - start.width) * t),
        height: round(start.height + (end.height - start.height) * t),
    }
}

pub fn expand_direction(ball: Point, work_area: Rect) -> Direction {
    Direction {
        horizontal: if ball.x + BALL / 2.0 - work_area.x > work_area.width / 2.0 { Horizontal::Left } else { Horizontal::Right },
        vertical: if ball.y - work_area.y < PANEL_H - BALL { Vertical::Down } else { Vertical::Up },
    }
}

pub fn ball_origin_from_window(bounds: Rect, direction: Direction) -> Point {
    Point {
        x: if direction.horizontal == Horizontal::Left { bounds.x + bounds.width - 12.0 - BALL } else { bounds.x + 12.0 },
        y: if direction.vertical == Vertical::Up { bounds.y + bounds.height - 12.0 - BALL } else { bounds.y + 12.0 },
    }
}

pub fn clamped_ball_origin(ball: Point, work_area: Rect) -> Point {
    Point {
        x: clamp(ball.x, work_area.x, work_area.x + work_area.width - BALL),
        y: clamp(ball.y, work_area.y, work_area.y + work_area.height - BALL),
    }
}

pub fn default_ball_origin(work_area: Rect) -> Point {
    let x = work_area.x + work_area.width - BALL;
    let y = work_area.y + (work_area.height - BALL) / 2.0 + work_area.height * BALL_DEFAULT_BELOW_CENTER;
    clamped_ball_origin(Point { x: round(x), y: round(y) }, work_area)
}

pub fn overlay_bounds_from_ball(ball: Point, direction: Direction) -> Rect {
    Rect {
        x: if direction.horizontal == Horizontal::Left { ball.x - (PANEL_W - BALL) - 12.0 } else { ball.x - 12.0 },
        y: if direction.vertical == Vertical::Up { ball.y - (PANEL_H - BALL) - 12.0 } else { ball.y - 12.0 },
        width: PANEL_WINDOW_W,
        height: PANEL_WINDOW_H,
    }
}

pub fn expanded_overlay_bounds(ball: Point, work_area: Rect) -> (Rect, Direction) {
    let direction = expand_direction(ball, work_area);
    let unclamped = overlay_bounds_from_ball(ball, direction);
    (
        Rect {
            x: clamp_window_origin(unclamped.x, work_area.x, work_area.width, unclamped.width),
            y: clamp_window_origin(unclamped.y, work_area.y, work_area.height, unclamped.height),
            width: unclamped.width,
            height: unclamped.height,
        },
        direction,
    )
}

pub fn window_center(bounds: Rect) -> Point {
    Point { x: bounds.x + bounds.width / 2.0, y: bounds.y + bounds.height / 2.0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: Rect = Rect { x: 0.0, y: 0.0, width: 1920.0, height: 1032.0 };

    #[test]
    fn default_origin_matches_orb() {
        // Orb: x = 1920 - 72, y = (1032 - 72) / 2 + 1032 * 0.08 = 480 + 82.56 -> 563
        assert_eq!(default_ball_origin(WORK), Point { x: 1848.0, y: 563.0 });
    }

    #[test]
    fn expands_away_from_the_right_edge() {
        let (rect, dir) = expanded_overlay_bounds(Point { x: 1848.0, y: 563.0 }, WORK);
        assert_eq!(dir, Direction { horizontal: Horizontal::Left, vertical: Vertical::Up });
        assert_eq!(rect, Rect { x: 1588.0, y: 203.0, width: 344.0, height: 444.0 });
    }

    #[test]
    fn docks_when_dragged_past_an_edge() {
        let bounds = Rect { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0 };
        assert_eq!(dock_side_for_ball_origin(Point { x: -20.0, y: 300.0 }, bounds), Some(Side::Left));
        assert_eq!(dock_side_for_ball_origin(Point { x: 1870.0, y: 300.0 }, bounds), Some(Side::Right));
        assert_eq!(dock_side_for_ball_origin(Point { x: 900.0, y: 300.0 }, bounds), None);
    }
}
