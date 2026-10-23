"""Run PySceneDetect in a cancellable child process without saving decoded frames."""
import json
import os
import sys

os.environ["OPENCV_FFMPEG_THREADS"] = "1"
import cv2
from scenedetect import SceneManager, open_video
from scenedetect.detectors import AdaptiveDetector


def main():
    cv2.setNumThreads(1)
    video = open_video(sys.argv[1])
    manager = SceneManager()
    manager.auto_downscale = True
    manager.add_detector(AdaptiveDetector())
    manager.detect_scenes(video=video, show_progress=False)
    scenes = manager.get_scene_list(start_in_scene=True)
    if not scenes:
        raise ValueError("未能解码视频画面，请检查原视频")
    print(json.dumps({"cuts": [start.get_seconds() for start, _ in scenes[1:]]}))


if __name__ == "__main__":
    main()
