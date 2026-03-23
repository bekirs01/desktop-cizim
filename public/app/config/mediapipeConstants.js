export const POSE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";
export const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
export const HAND_MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task";
export const WASM =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/wasm";

export const PERFORMANCE_MODE = true;
export const DETECT_EVERY_N_FRAMES = PERFORMANCE_MODE ? 2 : 1;
export const VIDEO_WIDTH = 1280;
export const VIDEO_HEIGHT = 720;
export const MIN_VIS = 0.15;
