module.exports = {
  apps: [{
    name: "claude-async-http",
    script: "claude-async-http.mjs",
    interpreter: "node",
    cwd: "C:\\Users\\Raide\\tools\\claude-async",
    autorestart: true,
    max_restarts: 10,
    env: {
      CLAUDE_ASYNC_HTTP_PORT: "7842",
      CLAUDE_CLI_PATH: "C:\\Users\\Raide\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
      CLAUDE_ASYNC_JOB_DIR: "C:\\Users\\Raide\\.claude-async-jobs",
      CLAUDE_ASYNC_TLS_CERT: "C:\\Users\\Raide\\tools\\claude-async\\certs\\127.0.0.1+1.pem",
      CLAUDE_ASYNC_TLS_KEY:  "C:\\Users\\Raide\\tools\\claude-async\\certs\\127.0.0.1+1-key.pem"
    }
  }]
};
