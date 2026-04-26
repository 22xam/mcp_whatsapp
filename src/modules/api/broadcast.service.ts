import { Injectable, Inject, Logger } from '@nestjs/common';
import { AI_PROVIDER } from '../core/tokens/injection-tokens';
import type { AIProvider } from '../core/interfaces/ai-provider.interface';
import { ConfigLoaderService } from '../config/config-loader.service';
import { WhatsAppAdapter } from '../messaging/adapters/whatsapp.adapter';

export interface BroadcastResult {
  phone: string;
  name?: string;
  status: 'sent' | 'failed' | 'skipped';
  error?: string;
}

@Injectable()
export class BroadcastService {
  private readonly logger = new Logger(BroadcastService.name);

  constructor(
    @Inject(AI_PROVIDER) private readonly aiProvider: AIProvider,
    private readonly configLoader: ConfigLoaderService,
    private readonly whatsAppAdapter: WhatsAppAdapter,
  ) {}

  async sendCampaignIntro(requestedPhones: string[]): Promise<BroadcastResult[]> {
    const clients = this.configLoader.clients;

    // Only send to phones registered in clients.json
    const targets = requestedPhones
      .map((phone) => {
        const normalized = phone.replace(/\D/g, '');
        const client = clients.find((c) => c.phone.replace(/\D/g, '') === normalized);
        return { phone: normalized, client };
      })
      .filter((t) => t.client !== undefined);

    const skipped = requestedPhones.filter((phone) => {
      const normalized = phone.replace(/\D/g, '');
      return !clients.find((c) => c.phone.replace(/\D/g, '') === normalized);
    });

    if (skipped.length > 0) {
      this.logger.warn(`Skipping non-client phones: ${skipped.join(', ')}`);
    }

    if (targets.length === 0) {
      return skipped.map((phone) => ({
        phone,
        status: 'skipped' as const,
        error: 'No registrado como cliente',
      }));
    }

    this.logger.log(`Starting campaign broadcast to ${targets.length} contacts`);
    const results: BroadcastResult[] = [];

    for (let i = 0; i < targets.length; i++) {
      const { phone, client } = targets[i];
      const recipientId = `${phone}@c.us`;

      let sent = false;
      let lastError = '';
      const maxAttempts = 3;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          this.logger.log(`Generating message for ${client!.name} (attempt ${attempt}/${maxAttempts})`);
          const message = await this.generateCampaignMessage(client!.name);
          await this.whatsAppAdapter.sendBroadcast(recipientId, message);
          this.logger.log(`Campaign message sent to ${client!.name} (${phone})`);
          results.push({ phone, name: client!.name, status: 'sent' });
          sent = true;
          break;
        } catch (error) {
          lastError = (error as Error).message;
          this.logger.warn(`Attempt ${attempt}/${maxAttempts} failed for ${phone}: ${lastError}`);
          if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 3000));
          }
        }
      }

      if (!sent) {
        this.logger.error(`All ${maxAttempts} attempts failed for ${phone}: ${lastError}`);
        results.push({ phone, name: client!.name, status: 'failed', error: lastError });
      }

      // Delay between recipients to avoid WhatsApp rate limiting
      if (i < targets.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }
    }

    skipped.forEach((phone) =>
      results.push({ phone, status: 'skipped', error: 'No registrado como cliente' }),
    );

    return results;
  }

  private async generateCampaignMessage(recipientName: string): Promise<string> {
    const prompt = `Escribí un mensaje de WhatsApp para enviarle a ${recipientName}, un docente de escuela técnica de Salta, Argentina.

El objetivo del mensaje es:
1. Saludarlo/a de manera cálida y personal, usando su nombre
2. Presentarte brevemente como Evangelina, asistente de Lista 26 Roja — Dignidad y Trabajo de AMET Regional XIII Salta
3. Contarle en 2-3 oraciones el corazón de la propuesta: defensa del Decreto 4659/12, Fondo Provincial de Educación Técnica, y bienestar del afiliado
4. Invitarlo/a a responder con cualquier consulta o a conocer más — dejá la puerta abierta a la conversación
5. Incluir el link al sitio: https://plataformalista26.vercel.app/ y el Instagram @lista26roja

El mensaje debe:
- Ser natural, como lo escribiría una compañera — NO un discurso político
- Usar español rioplatense/salteño, tuteo
- Tener entre 5 y 8 líneas, sin ser pesado
- Máximo 2 emojis, bien ubicados
- NO sonar como spam ni publicidad masiva
- Terminar con firma: *Evangelina* — Lista 26 Roja 🔴

Respondé solo con el mensaje listo para enviar, sin explicaciones ni comillas.`;

    const response = await this.aiProvider.generate({
      prompt,
      systemPrompt:
        'Sos Evangelina, asistente de Lista 26 Roja — Dignidad y Trabajo, AMET Regional XIII Salta. Escribís mensajes cálidos, genuinos y comprometidos con la causa docente.',
    });

    return response.text.trim();
  }
}
