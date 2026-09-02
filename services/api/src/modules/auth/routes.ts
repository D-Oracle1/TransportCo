import { Router } from 'express';
import {
  forgotPasswordSchema,
  loginSchema,
  refreshTokenSchema,
  registerCustomerSchema,
  registerPushTokenSchema,
  requestOtpSchema,
  resetPasswordSchema,
  verifyOtpSchema,
} from '@transportco/validation';
import { asyncHandler, sendCreated, sendOk } from '../../lib/http';
import { validateBody } from '../../middleware/validate';
import { authRateLimit, otpRateLimit } from '../../middleware/rateLimit';
import { authenticate, claimsOf } from '../../middleware/auth';
import * as authService from './service';

/**
 * Authentication routes.
 *
 * Public by design, and therefore the most heavily rate-limited surface in the
 * API. Login and OTP have their own budgets: OTP is keyed by phone number,
 * because each message costs money and the abuse case is enumerating numbers.
 */
export const authRouter = Router();

authRouter.post(
  '/register',
  authRateLimit,
  validateBody(registerCustomerSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.registerCustomer({
      ...req.body,
      deviceId: typeof req.headers['x-device-id'] === 'string' ? req.headers['x-device-id'] : undefined,
    });
    sendCreated(res, result);
  }),
);

authRouter.post(
  '/login',
  authRateLimit,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const session = await authService.login(req.body.identifier, req.body.password);
    sendOk(res, session);
  }),
);

authRouter.post(
  '/otp/request',
  otpRateLimit,
  validateBody(requestOtpSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await authService.requestOtp(req.body.phone, req.body.purpose));
  }),
);

authRouter.post(
  '/verify-otp',
  authRateLimit,
  validateBody(verifyOtpSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await authService.verifyOtp(req.body));
  }),
);

authRouter.post(
  '/forgot-password',
  otpRateLimit,
  validateBody(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await authService.requestOtp(req.body.phone, 'password_reset'));
  }),
);

authRouter.post(
  '/reset-password',
  authRateLimit,
  validateBody(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    await authService.resetPassword(req.body);
    sendOk(res, { reset: true });
  }),
);

authRouter.post(
  '/refresh',
  validateBody(refreshTokenSchema),
  asyncHandler(async (req, res) => {
    sendOk(res, await authService.refreshSession(req.body.refreshToken));
  }),
);

authRouter.post(
  '/logout',
  validateBody(refreshTokenSchema),
  asyncHandler(async (req, res) => {
    await authService.logout(req.body.refreshToken);
    sendOk(res, { loggedOut: true });
  }),
);

authRouter.post(
  '/push-tokens',
  authenticate,
  validateBody(registerPushTokenSchema),
  asyncHandler(async (req, res) => {
    await authService.registerPushToken({ userId: claimsOf(req).sub, ...req.body });
    sendOk(res, { registered: true });
  }),
);

/** Who am I — used by every client on launch to restore session state. */
authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const claims = claimsOf(req);
    sendOk(res, {
      userId: claims.sub,
      principalType: claims.principalType,
      customerId: claims.customerId ?? null,
      driverId: claims.driverId ?? null,
      roles: claims.roles,
      permissions: claims.permissions,
    });
  }),
);
