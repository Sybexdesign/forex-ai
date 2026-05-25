FROM python:3.11-slim

WORKDIR /app

COPY ml/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY ml/serve.py .
COPY ml/retrain.sh .
COPY ml/model/ ./model/

EXPOSE 8100

CMD ["python", "-u", "serve.py"]
