import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { JwtAuthGuard } from "../src/modules/auth/jwt-auth.guard";

const SECRET = "test-secret-at-least-32-characters-long!!";

function makeContext(authorization?: string, isPublic = false) {
  const request: Record<string, unknown> = { headers: { authorization } };
  const context = {
    getHandler: () => (isPublic ? "publicHandler" : "handler"),
    getClass: () => "TestClass",
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

function makeGuard(isPublic = false) {
  const reflector = {
    getAllAndOverride: jest.fn(() => isPublic),
  } as unknown as Reflector;
  const jwtService = new JwtService({ secret: SECRET });
  return { guard: new JwtAuthGuard(reflector, jwtService), jwtService };
}

describe("JwtAuthGuard", () => {
  it("@Public 放行且不解析 token", async () => {
    const { guard } = makeGuard(true);
    const { context } = makeContext(undefined, true);
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it("无 header / 非 Bearer / 坏 token → 401", async () => {
    const { guard } = makeGuard();
    await expect(guard.canActivate(makeContext(undefined).context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(guard.canActivate(makeContext("Basic abc").context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(guard.canActivate(makeContext("Bearer not-a-jwt").context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("合法 token 放行并挂 request.user", async () => {
    const { guard, jwtService } = makeGuard();
    const token = await jwtService.signAsync({
      sub: "8f14e45f-ceea-467f-a8d5-91be1a2f3b6d",
      email: "demo@codecrush.local",
    });
    const { context, request } = makeContext(`Bearer ${token}`);
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual({
      id: "8f14e45f-ceea-467f-a8d5-91be1a2f3b6d",
      email: "demo@codecrush.local",
    });
  });

  it("签名正确但缺少业务主体 claims → 401", async () => {
    const { guard, jwtService } = makeGuard();
    const token = await jwtService.signAsync({});
    await expect(guard.canActivate(makeContext(`Bearer ${token}`).context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
