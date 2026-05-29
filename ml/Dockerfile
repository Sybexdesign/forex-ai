FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY serve.py .
COPY worker_daily.py .
COPY market_data.py .
COPY retrain.sh .
COPY model/ ./model/

RUN mkdir -p /app/data

EXPOSE 8100

CMD ["python", "-u", "serve.py"]
