# Agent sandbox image: git, Node 24 (runs the stub agent with native type stripping) and Claude Code.
# The container has no direct internet access; everything it needs must be installed here.
FROM node:24-trixie-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
	&& rm -rf /var/lib/apt/lists/*

# Pinned: the flags and the stream-json event format change between releases. Used only when AGENT_MODE=claude.
RUN npm install --global @anthropic-ai/claude-code@2.1.280

# Helper binary @cloudflare/sandbox needs; the tag must match the installed package version.
COPY --from=docker.io/cloudflare/sandbox:1.0.0 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

COPY run-agent.sh stub-agent.mjs stub-agent-lib.ts /opt/delta/
RUN chmod +x /opt/delta/run-agent.sh

WORKDIR /workspace
# Keep the container running between execs.
CMD ["sleep", "infinity"]
