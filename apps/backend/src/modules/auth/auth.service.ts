import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { LoginResponse } from "@codecrush/contracts";
import { AppConfigService } from "../../platform/config/config.service";
import { UsersService } from "../users/users.service";

const EXPIRES_RE = /^(\d+)([smhd])$/;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

export function expiresInSeconds(expr: string): number {
  const m = EXPIRES_RE.exec(expr.trim());
  if (!m) throw new Error(`invalid JWT_EXPIRES_IN: ${expr}`);
  const seconds = Number(m[1]) * UNIT_SECONDS[m[2]];
  if (seconds <= 0) throw new Error(`invalid JWT_EXPIRES_IN: ${expr}`);
  return seconds;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly config: AppConfigService,
  ) {}

  async login(email: string, password: string): Promise<LoginResponse> {
    const user = await this.usersService.validateCredentials(email, password);
    if (!user) throw new UnauthorizedException("invalid credentials");
    const accessToken = await this.jwtService.signAsync({ sub: user.id, email: user.email });
    return {
      accessToken,
      tokenType: "Bearer",
      expiresIn: expiresInSeconds(this.config.jwtExpiresIn),
      user,
    };
  }
}
