FROM python:3.11-slim

WORKDIR /app

# Dépendances d'abord (layer cache)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Code source
COPY . .

# Les données (db, config) sont montées en volumes → non copiées dans l'image

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
