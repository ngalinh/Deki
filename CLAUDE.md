# Deki — Dev Notes

## VPS Deployment

- **Host**: 103.140.249.232 (vps-pro3)
- **SSH user**: vmadmin (có sudo)
- **Project path trên VPS**: `/app/data/bots/4b146b5d9fa4ff70`
- **PM2 app ID**: `4b146b5d9fa4ff70` (chạy dưới root)
- **Port**: 4102

## Auto Deploy

GitHub Actions tự động deploy khi push lên `main`:
- File: `.github/workflows/ci-deploy.yml`
- Secret cần có: `VPS_SSH_KEY` (private key của vmadmin)

## Manual Deploy (nếu cần)

```bash
cd /app/data/bots/4b146b5d9fa4ff70
git pull origin main
npm ci --omit=dev
sudo pm2 restart 4b146b5d9fa4ff70
```
