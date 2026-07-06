import { Body, Controller, Get, Patch, Req } from "@nestjs/common";
import { createZodDto } from "nestjs-zod";
import {
  ChangeOwnPasswordRequestSchema,
  type ChangeOwnPasswordResponse,
  type UserProfile,
} from "@codecrush/contracts";
import type { AuthenticatedUser } from "../../platform/security/authenticated-user";
import { UsersService } from "./users.service";

class ChangeOwnPasswordRequestDto extends createZodDto(ChangeOwnPasswordRequestSchema) {}

type AuthedRequest = { user: AuthenticatedUser };

@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get("me")
  async me(@Req() req: AuthedRequest): Promise<UserProfile> {
    return await this.usersService.getProfile(req.user.id);
  }

  @Patch("me/password")
  async changePassword(
    @Req() req: AuthedRequest,
    @Body() body: ChangeOwnPasswordRequestDto,
  ): Promise<ChangeOwnPasswordResponse> {
    await this.usersService.changeOwnPassword(req.user.id, body.currentPassword, body.newPassword);
    return { status: "ok" };
  }
}
