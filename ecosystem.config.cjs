/**
 * 📦 PM2 Ecosystem Config
 * 
 * Used for production deployment on VPS to ensure the API Bridge
 * stays online 24/7.
 */

module.exports = {
  apps: [
    {
      name: 'mc-api-bridge',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 4500,
        WS_PORT: 4501
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: './logs/pm2_error.log',
      out_file: './logs/pm2_out.log',
      merge_logs: true,
      // Exponential backoff restart
      exp_backoff_restart_delay: 100,
      restart_delay: 3000
    }
  ]
};
