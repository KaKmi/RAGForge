import { UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { AuthService, expiresInSeconds } from "../src/modules/auth/auth.service";
import type { UsersService } from "../src/modules/users/users.service";
import type { AppConfigService } from "../src/platform/config/config.service";

const SECRET = "test-secret-at-least-32-characters-long!!";
const profile = {
  id: "8f14e45f-ceea-467f-a8d5-91be1a2f3b6d",
  email: "demo@codecrush.local",
  displayName: "Demo Admin",
  status: "active",
  createdAt: "2026-07-05T00:00:00.000Z",
  updatedAt: "2026-07-05T00:00:00.000Z",
};

function makeService(valid: boolean) {
  const usersService = {
    validateCredentials: jest.fn(async () => (valid ? profile : null)),
  } as unknown as UsersService;
  const jwtService = new JwtService({ secret: SECRET });
  const config = { jwtExpiresIn: "12h" } as AppConfigService;
  return { service: new AuthService(usersService, jwtService, config), jwtService };
}

describe("expiresInSeconds", () => {
  it("解析 s/m/h/d，拒绝垃圾", () => {
    expect(expiresInSeconds("12h")).toBe(43200);
    expect(expiresInSeconds("30m")).toBe(1800);
    expect(() => expiresInSeconds("0h")).toThrow();
    expect(() => expiresInSeconds("whenever")).toThrow();
  });
});

describe("AuthService.login", () => {
  it("成功：返回可验签 token + 秒数 + sanitized user", async () => {
    const { service, jwtService } = makeService(true);
    const res = await service.login("demo@codecrush.local", "CodeCrushDemo123!");
    expect(res.tokenType).toBe("Bearer");
    expect(res.expiresIn).toBe(43200);
    expect(res.user).toEqual(profile);
    const payload = await jwtService.verifyAsync<{ sub: string; email: string }>(res.accessToken);
    expect(payload.sub).toBe(profile.id);
    expect(payload.email).toBe(profile.email);
  });

  it("失败：统一 401", async () => {
    const { service } = makeService(false);
    await expect(service.login("demo@codecrush.local", "wrong")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
