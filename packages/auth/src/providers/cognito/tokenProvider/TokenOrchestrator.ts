// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
	AuthTokens,
	FetchAuthSessionOptions,
	AuthConfig,
	Hub,
} from '@aws-amplify/core';
import {
	AMPLIFY_SYMBOL,
	assertTokenProviderConfig,
	isTokenExpired,
} from '@aws-amplify/core/internals/utils';
import {
	AuthTokenOrchestrator,
	AuthTokenStore,
	CognitoAuthTokens,
	DeviceMetadata,
	TokenRefresher,
} from './types';
import { assertServiceError } from '../../../errors/utils/assertServiceError';
import { AuthError } from '../../../errors/AuthError';
import { CognitoAuthSignInDetails } from '../types';

export class TokenOrchestrator implements AuthTokenOrchestrator {
	private authConfig?: AuthConfig;
	tokenStore?: AuthTokenStore;
	tokenRefresher?: TokenRefresher;
	waitForInflightOAuth: () => Promise<void> = async () => {};

	setAuthConfig(authConfig: AuthConfig) {
		this.authConfig = authConfig;
	}
	setTokenRefresher(tokenRefresher: TokenRefresher) {
		this.tokenRefresher = tokenRefresher;
	}
	setAuthTokenStore(tokenStore: AuthTokenStore) {
		this.tokenStore = tokenStore;
	}
	setWaitForInflightOAuth(waitForInflightOAuth: () => Promise<void>) {
		this.waitForInflightOAuth = waitForInflightOAuth;
	}

	getTokenStore(): AuthTokenStore {
		if (!this.tokenStore) {
			throw new AuthError({
				name: 'EmptyTokenStoreException',
				message: 'TokenStore not set',
			});
		}
		return this.tokenStore;
	}

	getTokenRefresher(): TokenRefresher {
		if (!this.tokenRefresher) {
			throw new AuthError({
				name: 'EmptyTokenRefresherException',
				message: 'TokenRefresher not set',
			});
		}
		return this.tokenRefresher;
	}

	async getTokens(
		options?: FetchAuthSessionOptions,
	): Promise<
		(AuthTokens & { signInDetails?: CognitoAuthSignInDetails }) | null
	> {
		let tokens: CognitoAuthTokens | null;

		try {
			assertTokenProviderConfig(this.authConfig?.Cognito);
		} catch (_err) {
			// Token provider not configured
			return null;
		}
		await this.waitForInflightOAuth();
		tokens = await this.getTokenStore().loadTokens();
		const username = await this.getTokenStore().getLastAuthUser();

		if (tokens === null) {
			return null;
		}
		const idTokenExpired =
			!!tokens?.idToken &&
			isTokenExpired({
				expiresAt: (tokens.idToken?.payload?.exp ?? 0) * 1000,
				clockDrift: tokens.clockDrift ?? 0,
			});
		const accessTokenExpired = isTokenExpired({
			expiresAt: (tokens.accessToken?.payload?.exp ?? 0) * 1000,
			clockDrift: tokens.clockDrift ?? 0,
		});

		if (options?.forceRefresh || idTokenExpired || accessTokenExpired) {
			tokens = await this.refreshTokens({
				tokens,
				username,
			});

			if (tokens === null) {
				return null;
			}
		}

		return {
			accessToken: tokens?.accessToken,
			idToken: tokens?.idToken,
			signInDetails: tokens?.signInDetails,
		};
	}

	private async refreshTokens({
		tokens,
		username,
	}: {
		tokens: CognitoAuthTokens;
		username: string;
	}): Promise<CognitoAuthTokens | null> {
		try {
			const newTokens = await this.getTokenRefresher()({
				tokens,
				authConfig: this.authConfig,
				username,
			});

			await this.setTokens({ tokens: newTokens });
			Hub.dispatch('auth', { event: 'tokenRefresh' }, 'Auth', AMPLIFY_SYMBOL);

			return newTokens;
		} catch (err) {
			return this.handleErrors(err);
		}
	}

	private handleErrors(err: unknown) {
		assertServiceError(err);
		if (err.message !== 'Network error') {
			// TODO(v6): Check errors on client
			this.clearTokens();
		}
		Hub.dispatch(
			'auth',
			{
				event: 'tokenRefresh_failure',
				data: { error: err },
			},
			'Auth',
			AMPLIFY_SYMBOL,
		);

		if (err.name.startsWith('NotAuthorizedException')) {
			return null;
		}
		throw err;
	}
	async setTokens({ tokens }: { tokens: CognitoAuthTokens }) {
		return this.getTokenStore().storeTokens(tokens);
	}

	async clearTokens() {
		return this.getTokenStore().clearTokens();
	}

	getDeviceMetadata(username?: string): Promise<DeviceMetadata | null> {
		return this.getTokenStore().getDeviceMetadata(username);
	}
	clearDeviceMetadata(username?: string): Promise<void> {
		return this.getTokenStore().clearDeviceMetadata(username);
	}
}
