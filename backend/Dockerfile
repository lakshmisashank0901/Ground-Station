FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 TF_CPP_MIN_LOG_LEVEL=2
WORKDIR /app

# TensorFlow is only needed to (re)train the LSTM; inference runs in numpy. Set INSTALL_TF=false for a
# much smaller image that falls back to the ridge predictor when retraining.
ARG INSTALL_TF=true
COPY requirements.txt requirements-ml.txt ./
RUN pip install -r requirements.txt && \
    if [ "$INSTALL_TF" = "true" ]; then pip install -r requirements-ml.txt; fi

COPY app ./app
COPY training ./training
# Train the models at build time so the container starts with loaded detectors.
ARG TRAIN_AT_BUILD=true
RUN if [ "$TRAIN_AT_BUILD" = "true" ]; then python -m training.train_all --fast $( [ "$INSTALL_TF" = "true" ] || echo --no-lstm ); fi

RUN useradd --create-home appuser && chown -R appuser /app
USER appuser
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD python -c "import urllib.request,sys; urllib.request.urlopen('http://localhost:8000/api/v1/health', timeout=4)" || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
