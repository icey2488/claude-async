const os = require("node:os");
const path = require("node:path");

module.exports = {
  apps: [{
    name: "claude-async-http",
    script: "claude-async-http.mjs",
    interpreter: "node",
    cwd: __dirname,
    autorestart: true,
    max_restarts: 10,
    env: {
      CLAUDE_ASYNC_HTTP_PORT: "7842",
      CLAUDE_CLI_PATH: process.env.CLAUDE_CLI_PATH || path.join(os.homedir(), ".local", "bin", "claude.exe"),
      CLAUDE_ASYNC_JOB_DIR: process.env.CLAUDE_ASYNC_JOB_DIR || path.join(os.homedir(), ".claude-async-jobs")
    }
  }]
};
