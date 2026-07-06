import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import type { AuthenticatedUser } from "../../platform/security/authenticated-user";
import { PUBLIC_ROUTE_KEY } from "../../platform/security/public.decorator";

type JwtPayload = { sub: string; email: string };
type RequestWithUser = { headers: { authorization?: string }; user?: AuthenticatedUser };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("missing bearer token");
    }
    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(
        header.slice("Bearer ".length).trim(),
      );
      if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
        throw new UnauthorizedException("invalid token principal");
      }
      request.user = { id: payload.sub, email: payload.email };
      return true;
    } catch {
      throw new UnauthorizedException("invalid or expired token");
    }
  }
}
