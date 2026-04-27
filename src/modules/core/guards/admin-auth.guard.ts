import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const token = this.config.get<string>('BOT_OSCAR_ADMIN_TOKEN');
    if (!token) return true;

    const request = context.switchToHttp().getRequest<Request>();
    if (!request.path?.startsWith('/api')) return true;

    const headerToken = request.header('x-admin-token');
    const authorization = request.header('authorization');
    const bearer = authorization?.toLowerCase().startsWith('bearer ')
      ? authorization.slice(7)
      : undefined;

    return headerToken === token || bearer === token;
  }
}
