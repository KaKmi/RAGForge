import { Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import type { UserProfile } from "@codecrush/contracts";
import { hashPassword, verifyPassword } from "./password";
import type { UserRow } from "./schema";
import { UsersRepository } from "./users.repository";

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function toProfile(row: UserRow): UserProfile {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class UsersService {
  private dummyHash: string | undefined;

  constructor(private readonly usersRepository: UsersRepository) {}

  async getProfile(userId: string): Promise<UserProfile> {
    const row = await this.usersRepository.findById(userId);
    if (!row) throw new NotFoundException("user not found");
    return toProfile(row);
  }

  async validateCredentials(email: string, password: string): Promise<UserProfile | null> {
    const row = await this.usersRepository.findByEmail(normalizeEmail(email));
    if (!row) {
      // 未知用户也跑一次 verify，抑制用户枚举的时序差。
      await verifyPassword(await this.getDummyHash(), password);
      return null;
    }
    return (await verifyPassword(row.passwordHash, password)) ? toProfile(row) : null;
  }

  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const row = await this.usersRepository.findById(userId);
    if (!row) throw new NotFoundException("user not found");
    if (!(await verifyPassword(row.passwordHash, currentPassword))) {
      throw new UnauthorizedException("current password is incorrect");
    }
    await this.usersRepository.updatePasswordHash(userId, await hashPassword(newPassword));
  }

  private async getDummyHash(): Promise<string> {
    if (!this.dummyHash) this.dummyHash = await hashPassword("dummy-password-for-timing");
    return this.dummyHash;
  }
}
