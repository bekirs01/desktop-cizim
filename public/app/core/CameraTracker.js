import {
  PoseLandmarker,
  FaceLandmarker,
  HandLandmarker,
  FilesetResolver,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32/vision_bundle.mjs";

import {
  POSE_MODEL,
  FACE_MODEL,
  HAND_MODEL,
  WASM,
} from "../config/mediapipeConstants.js";

class CameraTracker {
  constructor() {
    this.poseLandmarker = null;
    this.faceLandmarker = null;
    this.handLandmarker = null;
    this.mediaPipeLoadPromise = null;
    this.stream = null;
    this.cameraStartPromise = null;
    this.cameraStartEpoch = 0;
  }

  async ensureMediaPipeModelsLoaded() {
    if (this.poseLandmarker && this.faceLandmarker && this.handLandmarker) return;
    if (!this.mediaPipeLoadPromise) {
      this.mediaPipeLoadPromise = (async () => {
        const vision = await FilesetResolver.forVisionTasks(WASM);
        const [p, f, h] = await Promise.all([
          PoseLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: POSE_MODEL, delegate: "GPU" },
            runningMode: "VIDEO",
            numPoses: 1,
            minPoseDetectionConfidence: 0.4,
            minPosePresenceConfidence: 0.25,
            minTrackingConfidence: 0.25,
          }),
          FaceLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: FACE_MODEL, delegate: "GPU" },
            runningMode: "VIDEO",
            numFaces: 1,
            outputFaceBlendshapes: true,
          }),
          HandLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: HAND_MODEL, delegate: "GPU" },
            runningMode: "VIDEO",
            numHands: 4,
            minHandDetectionConfidence: 0.2,
            minHandPresenceConfidence: 0.2,
            minTrackingConfidence: 0.2,
          }),
        ]);
        this.poseLandmarker = p;
        this.faceLandmarker = f;
        this.handLandmarker = h;
      })();
    }
    try {
      await this.mediaPipeLoadPromise;
    } catch (err) {
      this.mediaPipeLoadPromise = null;
      this.poseLandmarker = this.faceLandmarker = this.handLandmarker = null;
      console.error("Ошибка загрузки модели:", err);
      throw err;
    }
  }

  async openCameraStreamWithFallback(cameraProfile) {
    const tries = [
      {
        video: {
          facingMode: "user",
          width: { ideal: cameraProfile.width, max: cameraProfile.maxWidth },
          height: { ideal: cameraProfile.height, max: cameraProfile.maxHeight },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      },
      {
        video: {
          facingMode: "user",
        },
        audio: false,
      },
      {
        video: true,
        audio: false,
      },
    ];
    let lastErr = null;
    for (const c of tries) {
      try {
        return await navigator.mediaDevices.getUserMedia(c);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("Не удалось открыть камеру");
  }

  async startCamera(videoElement, cameraProfile) {
    if (this.stream?.active && videoElement?.srcObject) return this.stream;
    if (this.cameraStartPromise) return this.cameraStartPromise;
    const epoch = ++this.cameraStartEpoch;
    this.cameraStartPromise = (async () => {
      try {
        if (window.location.protocol === "file:") {
          throw new Error("FILE_PROTOCOL");
        }
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("Ваш браузер не поддерживает камеру. Используйте Chrome или Firefox.");
        }

        const [, camStream] = await Promise.all([
          this.ensureMediaPipeModelsLoaded().catch((e) => console.warn("Ошибка загрузки модели:", e)),
          this.openCameraStreamWithFallback(cameraProfile),
        ]);

        if (epoch !== this.cameraStartEpoch) {
          camStream.getTracks().forEach((t) => t.stop());
          return null;
        }

        this.stream = camStream;
        videoElement.srcObject = this.stream;
        videoElement.muted = true;
        videoElement.setAttribute("playsinline", "true");
        videoElement.setAttribute("webkit-playsinline", "true");

        try {
          await videoElement.play();
        } catch (playErr) {
          throw new Error("Не удалось воспроизвести видео. Обновите страницу и попробуйте снова.");
        }

        let wait = 0;
        while ((videoElement.videoWidth === 0 || videoElement.videoHeight === 0) && wait < 60) {
          await new Promise((r) => setTimeout(r, 50));
          wait++;
        }

        return this.stream;
      } catch (err) {
        if (this.stream) {
          this.stream.getTracks().forEach((t) => t.stop());
          this.stream = null;
        }
        videoElement.srcObject = null;
        throw err;
      } finally {
        if (this.cameraStartEpoch === epoch) {
          this.cameraStartPromise = null;
        }
      }
    })();
    return this.cameraStartPromise;
  }

  stopCamera(videoElement) {
    this.cameraStartEpoch++;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (videoElement) {
      videoElement.srcObject = null;
    }
    this.cameraStartPromise = null;
  }

  detectForVideo(videoElement, timestamp, options = { pose: true, face: true, hand: true }) {
    return {
      pose: (options.pose && this.poseLandmarker) ? this.poseLandmarker.detectForVideo(videoElement, timestamp) : null,
      face: (options.face && this.faceLandmarker) ? this.faceLandmarker.detectForVideo(videoElement, timestamp) : null,
      hand: (options.hand && this.handLandmarker) ? this.handLandmarker.detectForVideo(videoElement, timestamp) : null,
    };
  }

  getHandLandmarker() {
    return this.handLandmarker;
  }
  
  getFaceLandmarker() {
    return this.faceLandmarker;
  }

  getPoseLandmarker() {
    return this.poseLandmarker;
  }
}

const cameraTracker = new CameraTracker();
export default cameraTracker;
