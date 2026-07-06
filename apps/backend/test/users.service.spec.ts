import { NotFoundException, UnauthorizedException } from "@nestjs/common";
import { hashPassword, verifyPassword } from "../src/modules/users/password";
import { UsersService, normalizeEmail } from "../src/modules/users/users.service";
import type { UsersRepository } from "../src/modules/users/users.repository";
import type { UserRow } from "../src/modules/users/schema";

jest.setTimeout(30000);

const now = new Date("2026-07-05T00:00:00.000Z");
function makeRow(passwordHash: string): UserRow {
  return {
    id: "8f14e45f-ceea-467f-a8d5-91be1a2f3b6d",
    email: "demo@codecrush.local",
    displayName: "Demo Admin",
    passwordHash,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

describe("password helper", () => {
  it("hash/verify roundtrip; wrong password false", async () => {
    const hash = await hashPassword("CodeCrushDemo123!");
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, "CodeCrushDemo123!")).toBe(true);
    expect(await verifyPassword(hash, "wrong")).toBe(false);
  });
});

describe("UsersService", () => {
  it("normalizes email", () => {
    expect(normalizeEmail("  Demo@CodeCrush.LOCAL ")).toBe("demo@codecrush.local");
  });

  it("validateCredentials: 成功返回 sanitized profile（无 passwordHash）", async () => {
    const hash = await hashPassword("CodeCrushDemo123!");
    const repo = {
      findByEmail: jest.fn(async () => makeRow(hash)),
    } as unknown as UsersRepository;
    const service = new UsersService(repo);
    const profile = await service.validateCredentials("Demo@CodeCrush.local", "CodeCrushDemo123!");
    expect(profile).toMatchObject({ email: "demo@codecrush.local", displayName: "Demo Admin" });
    expect(profile && ("passwordHash" in profile || "password_hash" in profile)).toBe(false);
    expect((repo.findByEmail as jest.Mock).mock.calls[0][0]).toBe("demo@codecrush.local");
  });

  it("validateCredentials: 未知用户也执行一次 dummy verify（抑制枚举时序）", async () => {
    const repo = { findByEmail: jest.fn(async () => undefined) } as unknown as UsersRepository;
    const service = new UsersService(repo);
    const spy = jest.spyOn(
      service as unknown as { getDummyHash: () => Promise<string> },
      "getDummyHash",
    );
    expect(await service.validateCredentials("nobody@x.local", "whatever")).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("changeOwnPassword: current 错 → Unauthorized；未知 user → NotFound", async () => {
    const hash = await hashPassword("CodeCrushDemo123!");
    const update = jest.fn(async () => undefined);
    const repo = {
      findById: jest.fn(async () => makeRow(hash)),
      updatePasswordHash: update,
    } as unknown as UsersRepository;
    const service = new UsersService(repo);
    await expect(
      service.changeOwnPassword(
        "8f14e45f-ceea-467f-a8d5-91be1a2f3b6d",
        "wrong",
        "NewPassword456!",
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await service.changeOwnPassword(
      "8f14e45f-ceea-467f-a8d5-91be1a2f3b6d",
      "CodeCrushDemo123!",
      "NewPassword456!",
    );
    expect(update).toHaveBeenCalled();

    const emptyRepo = { findById: jest.fn(async () => undefined) } as unknown as UsersRepository;
    await expect(
      new UsersService(emptyRepo).changeOwnPassword("no-such", "a", "NewPassword456!"),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
