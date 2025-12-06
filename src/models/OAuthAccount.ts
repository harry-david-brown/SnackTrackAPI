export interface OAuthAccount {
    id: string;
    userId: string;
    provider: string; // 'google', 'apple', etc.
    providerUserId: string;
    email?: string;
    accessToken?: string;
    refreshToken?: string;
    tokenExpiry?: Date;
    createdAt: Date;
    updatedAt: Date;
}
