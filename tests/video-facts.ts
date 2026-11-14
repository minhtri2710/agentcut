// The probe fields a hand-built video asset needs to validate: a file that starts at 0, in a format whose seek lands at or before its target, with no reordering.
export const VIDEO_FACTS = { container_start: 0, video_start: 0, format: "mov,mp4,m4a,3gp,3g2,mj2", reorder: 0 };
