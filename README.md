# Blips Website

Official website for the Blips mobile app.

## Features

- Landing page with app information
- Privacy Policy and Terms of Service
- Password reset redirect handler (fixes deep link issue)
- Responsive design
- Fast loading with modern CSS

## Deployment Instructions

### Deploy to Vercel (Recommended - Free)

1. **Install Vercel CLI** (if not already installed):
   ```bash
   npm install -g vercel
   ```

2. **Deploy the website**:
   ```bash
   cd blips-website
   vercel
   ```

3. **Follow the prompts**:
   - Set up and deploy: Yes
   - Which scope: Your account
   - Link to existing project: No
   - Project name: blips-website
   - Directory: `./` (current directory)
   - Override settings: No

4. **Add custom domain** (blipsdigital.com):
   - Go to your Vercel dashboard
   - Select the blips-website project
   - Go to Settings → Domains
   - Add `blipsdigital.com` and `www.blipsdigital.com`
   - Follow DNS instructions to point your domain to Vercel

5. **Update Supabase configuration**:
   - Go to Supabase Dashboard → Auth → URL Configuration
   - Update redirect URL from `blips://auth/reset-password` to:
     `https://blipsdigital.com/auth/reset-password`
   - Save changes

6. **Update app code** (in forgot-password.tsx):
   ```typescript
   redirectTo: 'https://blipsdigital.com/auth/reset-password'
   ```

## Files

- `index.html` - Landing page
- `styles.css` - All styles
- `privacy.html` - Privacy Policy
- `terms.html` - Terms of Service
- `auth/reset-password.html` - Password reset handler (critical for deep linking)
- `vercel.json` - Vercel deployment configuration

## Password Reset Flow

1. User requests password reset in app
2. Supabase sends email with link to `https://blipsdigital.com/auth/reset-password#access_token=...`
3. Website receives link with tokens in hash fragment
4. JavaScript extracts tokens and redirects to `blips://auth/reset-password?access_token=...`
5. iOS opens Blips app with tokens as query parameters
6. App exchanges tokens for session and shows password reset screen

This solves the iOS deep link issue where hash fragments are stripped during browser → app transitions.

## Support

For questions or issues, contact: support@blipsdigital.com
