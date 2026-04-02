module.exports = {
  apps: [{
    name: 'fedihome',
    script: 'npm',
    args: 'start',
    cwd: __dirname,
    env: {
      NODE_ENV: 'production',
    },
    // Auto-restart on crash
    max_restarts: 10,
    min_uptime: '10s',
    restart_delay: 5000,
  }],
};
