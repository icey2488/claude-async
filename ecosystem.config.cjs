module.exports = {
  apps: [{
    name: "claude-async-http",
    script: "claude-async-http.mjs",
    interpreter: "node",
    cwd: "D:\\code\\claude-async",
    autorestart: true,
    max_restarts: 10,
    env: {
      CLAUDE_ASYNC_HTTP_PORT: "7842",
      CLAUDE_CLI_PATH: "C:\\Users\\Raide\\.local\\bin\\claude.exe",
      CLAUDE_ASYNC_JOB_DIR: "C:\\Users\\Raide\\.claude-async-jobs"
    }
  }]
};
