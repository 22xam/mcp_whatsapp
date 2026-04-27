import { Injectable } from '@nestjs/common';
import { ClientsService } from '../clients/clients.service';
import type { ClientConfig } from '../config/types/bot-config.types';
import type { ValidateDataSource } from '../config/types/conditional-flow.types';

@Injectable()
export class ValidateService {
  constructor(private readonly clientsService: ClientsService) {}

  /**
   * Validates a user input string against the specified data source.
   * Returns the matched record or null.
   *
   * Matching strategy:
   * 1. Exact phone number match
   * 2. Fuzzy name/company match (case-insensitive, strips legal suffixes)
   */
  validate(dataSource: ValidateDataSource, input: string): ClientConfig | null {
    if (dataSource === 'clients') {
      return this.validateClient(input);
    }
    return null;
  }

  private validateClient(input: string): ClientConfig | null {
    const normalized = this.normalize(input);
    const clients = this.clientsService.findAll();

    // 1. Exact phone match
    const byPhone = clients.find((c) => {
      const phone = c.phone.replace(/\D/g, '');
      return normalized.replace(/\D/g, '') === phone;
    });
    if (byPhone) return byPhone;

    // 2. Fuzzy name or company match
    return (
      clients.find((c) => {
        const nameNorm = this.normalize(c.name);
        const companyNorm = this.normalize(c.company);
        // Check if the input contains the client's name or company, or vice versa
        return (
          normalized.includes(nameNorm) ||
          nameNorm.includes(normalized) ||
          normalized.includes(companyNorm) ||
          companyNorm.includes(normalized)
        );
      }) ?? null
    );
  }

  private normalize(text: string): string {
    return text
      .toLowerCase()
      .replace(/\b(s\.?a\.?|s\.?r\.?l\.?|s\.?a\.?s\.?|ltda\.?|inc\.?|corp\.?)\b/g, '')
      .replace(/[^a-záéíóúüñ0-9\s]/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
