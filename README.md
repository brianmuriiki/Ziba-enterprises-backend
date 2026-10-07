# Ziba Enterprises Backend

Express API with MongoDB and Mongoose. Source is organized into `models`, `controllers`, `routes`, `middleware`, and `database` modules.

## Run locally

1. Run `npm install` in this directory.
2. Create a local `.env` file with `MONGODB_URI`, a long random `JWT_SECRET`, `ADMIN_EMAIL`, and optional `API_PORT` and `CLIENT_ORIGIN` values.
3. Start MongoDB, then run `npm run dev` (or `npm start`). The API listens on port 3000 by default.

Register the address configured in `ADMIN_EMAIL` to initialize the first admin account. Set the frontend's `VITE_API_URL` to `http://localhost:3000/api` for local development.

Uploaded files are currently stored as data URLs in MongoDB. Use object storage before production deployment. Do not commit `.env` or expose `JWT_SECRET` to the frontend.
