import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import { LoginRequestSchema, type LoginResponse } from "@codecrush/contracts";
import { Public } from "../../platform/security/public.decorator";
import { AuthService } from "./auth.service";

class LoginRequestDto extends createZodDto(LoginRequestSchema) {}

@Controller("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @HttpCode(200)
  @Post("login")
  async login(@Body() body: LoginRequestDto): Promise<LoginResponse> {
    return await this.authService.login(body.email, body.password);
  }
}
