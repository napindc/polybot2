import type { DiscordUserId, PolymarketAccountId, UserIdentity } from '../types';

/**
 * Security boundary for auth module:
 * - Handles account-linking flow contracts only.
 * - Never stores private keys.
 * - Never signs transactions.
 * - Never accepts credentials from Discord messages.
 * - Assumes user authentication completes in a web app redirect flow.
 */

/**
 * Opaque identifier for a login session used during redirect-based linking.
 * Branded type prevents accidental mixing with unrelated strings.
 */
export type AuthSessionId = string & { readonly __brand: 'AuthSessionId' };

/**
 * Opaque anti-CSRF nonce for redirect verification.
 * Branded type supports safer parameter handling.
 */
export type AuthState = string & { readonly __brand: 'AuthState' };

/**
 * URL string used for browser redirect to external authentication.
 * Branded for clarity at API boundaries.
 */
export type RedirectUrl = string & { readonly __brand: 'RedirectUrl' };

/**
 * Request to initiate account-linking for a Discord user.
 * This contract does not carry credentials.
 */
export interface InitiatePolymarketLoginInput {
  /** Discord user requesting account linking. */
  readonly discordUserId: DiscordUserId;
  /** Absolute callback URL in the web app where auth provider returns the user. */
  readonly callbackUrl: string;
}

/**
 * Result returned when a login flow is initiated.
 * Caller sends redirectUrl to the web client and persists session metadata.
 */
export interface InitiatePolymarketLoginResult {
  /** Server-generated auth session identifier for correlation. */
  readonly authSessionId: AuthSessionId;
  /** Anti-CSRF state token that must match on callback verification. */
  readonly state: AuthState;
  /** Destination URL for browser redirect login flow. */
  readonly redirectUrl: RedirectUrl;
  /** Expiration timestamp for session validity in epoch milliseconds. */
  readonly expiresAtMs: number;
}

/**
 * Callback payload after user completes login in the web app.
 * Contains provider-returned values only; no Discord message content.
 */
export interface VerifyPolymarketLoginInput {
  /** Correlation ID generated during initiation. */
  readonly authSessionId: AuthSessionId;
  /** State returned from provider redirect; must match stored state. */
  readonly state: AuthState;
  /** Provider authorization code from redirect flow. */
  readonly authorizationCode: string;
}

/**
 * Deterministic verification output for link completion.
 * Returns account identity only if verification succeeds.
 */
export interface VerifyPolymarketLoginResult {
  /** Whether callback verification succeeded. */
  readonly ok: boolean;
  /** Linked identity when successful; absent on failure. */
  readonly identity?: UserIdentity;
  /** Stable error code for deterministic caller handling. */
  readonly errorCode?: 'INVALID_SESSION' | 'STATE_MISMATCH' | 'EXPIRED_SESSION' | 'PROVIDER_ERROR';
}

/**
 * Repository contract for storing and retrieving Discord↔Polymarket bindings.
 * Storage implementation is separated for testability and infrastructure independence.
 */
export interface UserIdentityRepository {
  /** Upsert a user binding after successful login verification. */
  saveBinding(identity: UserIdentity): Promise<void>;
  /** Get a binding by Discord user ID. */
  getByDiscordUserId(discordUserId: DiscordUserId): Promise<UserIdentity | null>;
  /** Get a binding by Polymarket account ID. */
  getByPolymarketAccountId(polymarketAccountId: PolymarketAccountId): Promise<UserIdentity | null>;
  /** Remove a binding (e.g., unlink flow). */
  deleteByDiscordUserId(discordUserId: DiscordUserId): Promise<void>;
}

/**
 * Session store contract for temporary login-flow state.
 * Keeps redirect correlation deterministic and testable.
 */
export interface PolymarketAuthSessionStore {
  /** Persist session metadata for later verification. */
  create(session: PolymarketAuthSession): Promise<void>;
  /** Load session by ID for callback validation. */
  getById(authSessionId: AuthSessionId): Promise<PolymarketAuthSession | null>;
  /** Delete session after completion/expiry to enforce one-time use. */
  deleteById(authSessionId: AuthSessionId): Promise<void>;
}

/**
 * Internal session metadata persisted between initiation and callback verification.
 */
export interface PolymarketAuthSession {
  /** Session correlation identifier. */
  readonly authSessionId: AuthSessionId;
  /** Discord user initiating the link flow. */
  readonly discordUserId: DiscordUserId;
  /** Anti-CSRF state to verify callback integrity. */
  readonly state: AuthState;
  /** Session expiration in epoch milliseconds. */
  readonly expiresAtMs: number;
}

/**
 * Public service interface for polymarket account linking.
 * This abstraction isolates auth from trading and Discord transport concerns.
 */
export interface PolymarketAuthService {
  /** Start redirect-based login flow for a Discord user. */
  initiateLogin(input: InitiatePolymarketLoginInput): Promise<InitiatePolymarketLoginResult>;
  /** Verify callback and resolve linked account identity. */
  verifyLogin(input: VerifyPolymarketLoginInput): Promise<VerifyPolymarketLoginResult>;
  /** Retrieve existing binding for a Discord user. */
  getLinkedAccount(discordUserId: DiscordUserId): Promise<PolymarketAccountId | null>;
}

/**
 * Stub implementation for development and tests.
 * - Contains no provider API calls.
 * - Contains no signing logic.
 * - Uses injected repositories for deterministic behavior.
 */
export class PolymarketAuthServiceStub implements PolymarketAuthService {
  public constructor(
    private readonly identityRepository: UserIdentityRepository,
    private readonly sessionStore: PolymarketAuthSessionStore,
  ) {}

  /**
   * Stub: initiation flow is not implemented yet.
   * Kept explicit to prevent accidental partial auth behavior in production.
   */
  public async initiateLogin(_: InitiatePolymarketLoginInput): Promise<InitiatePolymarketLoginResult> {
    throw new Error('Not implemented: initiateLogin');
  }

  /**
   * Stub: callback verification against provider is not implemented yet.
   * Method exists to lock the integration contract before provider wiring.
   */
  public async verifyLogin(_: VerifyPolymarketLoginInput): Promise<VerifyPolymarketLoginResult> {
    throw new Error('Not implemented: verifyLogin');
  }

  /**
   * Deterministic repository read for currently linked account.
   * No external API calls and no business logic beyond mapping output shape.
   */
  public async getLinkedAccount(discordUserId: DiscordUserId): Promise<PolymarketAccountId | null> {
    const identity = await this.identityRepository.getByDiscordUserId(discordUserId);
    return identity?.polymarketAccountId ?? null;
  }

  /**
   * Exposes dependency for tests to assert wiring without runtime casts.
   */
  public getSessionStoreForTesting(): PolymarketAuthSessionStore {
    return this.sessionStore;
  }
}
