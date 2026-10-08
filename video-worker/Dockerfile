FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
WORKDIR /worker
COPY requirements*.txt ./
RUN pip install --no-cache-dir -r requirements-ai.txt
COPY app.py ./
COPY adapters ./adapters
ENV VIDEO_WORKER_DATA=/data
ENV SUBTITLE_FONT="Noto Sans CJK SC"
EXPOSE 8767
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8767"]
