FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY serve.py .
COPY retrain.sh .
COPY model/ ./model/

EXPOSE 8100

CMD ["python", "-u", "serve.py"]
