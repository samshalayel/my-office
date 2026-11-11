# HTTPS Setup Guide for POS Application

This guide explains how to set up HTTPS for the POS application, which is required for Service Worker support.

## Requirements

Service Workers require HTTPS in production environments (or localhost for development). This is a security requirement to ensure that only trusted code can interact with the Service Worker.

## Local Development (with HTTPS)

### Option 1: Using self-signed certificates

```bash
# Generate self-signed certificate (valid for 365 days)
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes

# Set environment variables
export ENABLE_HTTPS=true
export SSL_CERT_PATH=./cert.pem
export SSL_KEY_PATH=./key.pem

# Start the application
npm start
```

### Option 2: Using mkcert (recommended)

```bash
# Install mkcert
brew install mkcert  # macOS
sudo apt install mkcert  # Ubuntu
choco install mkcert  # Windows

# Create local CA
mkcert -install

# Generate certificate for localhost
mkcert localhost 127.0.0.1 ::1

# Use the generated files in your environment
export ENABLE_HTTPS=true
export SSL_CERT_PATH=./localhost.pem
export SSL_KEY_PATH=./localhost-key.pem
```

## Production Deployment

### Using Let's Encrypt with Nginx

```nginx
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name your-domain.com;

    # SSL certificates from Let's Encrypt
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Redirect to Node.js application
    location / {
        proxy_pass https://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}
```

### Using Let's Encrypt Certificate

```bash
# Install certbot
sudo apt-get install certbot python3-certbot-nginx

# Obtain certificate
sudo certbot certonly --nginx -d your-domain.com

# Renewal (automatic with certbot)
sudo certbot renew --dry-run
```

### Environment Variables for Production

```bash
export ENABLE_HTTPS=true
export NODE_ENV=production
export SSL_CERT_PATH=/etc/letsencrypt/live/your-domain.com/fullchain.pem
export SSL_KEY_PATH=/etc/letsencrypt/live/your-domain.com/privkey.pem
export PORT=3000
```

## Security Best Practices

1. **Always use HTTPS in production** - This is required for Service Workers
2. **Use strong TLS versions** - Support TLS 1.2 and above only
3. **Enable HSTS** - Add the Strict-Transport-Security header to force HTTPS
4. **Secure headers** - Implement security headers (X-Content-Type-Options, X-Frame-Options, etc.)
5. **Certificate rotation** - Regularly update SSL certificates (Let's Encrypt provides 90-day certificates)
6. **Monitor certificate expiry** - Set up alerts for certificate expiration

## Application Configuration

The application automatically uses HTTPS when:
- `ENABLE_HTTPS` environment variable is set to `true`
- Valid `SSL_CERT_PATH` and `SSL_KEY_PATH` are provided

If HTTPS is not configured, the application will fail to start in production mode.

## Testing HTTPS Connection

```bash
# Test with curl
curl -k https://localhost:3000

# Test certificate validity
openssl s_client -connect localhost:3000

# Test security headers
curl -i https://localhost:3000
```

## Troubleshooting

### Certificate not found
- Ensure the paths in `SSL_CERT_PATH` and `SSL_KEY_PATH` are correct
- Check file permissions (certificate files should be readable)

### Port already in use
- Change the `PORT` environment variable (default: 3000)
- Or kill the process using that port

### Certificate expired
- Renew the certificate immediately
- Set up automatic renewal with Let's Encrypt

## References

- [MDN: Service Workers and HTTPS](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API#https_requirement)
- [Let's Encrypt](https://letsencrypt.org/)
- [Nginx SSL Configuration](https://nginx.org/en/docs/http/ngx_http_ssl_module.html)
- [OWASP TLS Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Protection_Cheat_Sheet.html)
