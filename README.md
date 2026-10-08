# Ziba Enterprises Backend

Express API with MongoDB and Mongoose. Source is organized into `models`, `controllers`, `routes`, `middleware`, and `database` modules.

## Run locally

1. Run `npm install` in this directory.
2. Copy `.env.example` to `.env` in this directory. Set `MONGODB_URI` to your MongoDB connection string and replace `JWT_SECRET` with a long random value (for example, generate one with `openssl rand -base64 32`).
3. Start MongoDB, then run `npm run dev` (or `npm start`). The API listens on port 3000 by default.

Register the account that should administer the site, then promote it from the backend directory with `npm run admin:promote -- account@example.com`. Promotion requires access to the server environment; public registration never grants admin privileges. Set the frontend's `VITE_API_URL` to `http://localhost:3000/api` for local development.

Uploaded files are currently stored as data URLs in MongoDB. Use object storage before production deployment. Do not commit `.env` or expose `JWT_SECRET` to the frontend.

## Google sign-in

Create a **Web application** OAuth client in the Google Cloud Console. Add the frontend origin (for local development, `http://localhost:8443`) under **Authorized JavaScript origins**. Copy its client ID into `GOOGLE_CLIENT_ID` in `backend/.env` and `VITE_GOOGLE_CLIENT_ID` in `frontend/.env.local`; both values must match. Restart both development servers after changing the environment files. The backend validates Google ID tokens and then issues the usual Ziba session token. Google sign-in requires network access from the backend to Google's certificate endpoint.

## AI marketplace assistant

Add your OpenRouter key to `OPENROUTER_API_KEY` in `backend/.env`. The default `OPENROUTER_MODEL=openrouter/free` routes requests to an available free model that supports the assistant's tools. You can set `OPENROUTER_MODEL` to another model available to your OpenRouter account. Keep the key in the backend only; do not add it to a `VITE_` variable. The assistant uses read-only tools to search active public products, properties, and services. Each chat request is rate limited.
