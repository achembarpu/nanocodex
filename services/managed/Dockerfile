FROM docker.io/cloudflare/sandbox:0.12.4

RUN apt-get update \
    && apt-get install -y --no-install-recommends cargo rustc \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 3000
EXPOSE 5173
EXPOSE 8000
EXPOSE 8080
