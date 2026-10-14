import { createAuthClient } from "better-auth/react";

// Browser-side client for sign-in and sign-out; it talks to /api/auth on the same origin.
export const authClient = createAuthClient();
