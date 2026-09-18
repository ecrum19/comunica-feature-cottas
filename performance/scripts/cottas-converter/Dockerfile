FROM python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c

COPY requirements.txt /converter/requirements.txt
RUN pip install --no-cache-dir -r /converter/requirements.txt
COPY convert.py /converter/convert.py
ENTRYPOINT ["python", "/converter/convert.py"]
