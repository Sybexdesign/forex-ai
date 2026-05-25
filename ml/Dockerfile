FROM python:3.11-slim

WORKDIR /app

# Install dependencies first (cache layer)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy ML code
COPY serve.py .
COPY retrain.sh .

# Copy model if it exists (optional — container starts without it and
# waits for the model to be mounted or trained in place)
COPY model/ ./model/ 2>/dev/null || true

EXPOSE 8100

CMD ["python", "-u", "serve.py"]
