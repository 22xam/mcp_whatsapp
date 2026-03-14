import { Injectable, Logger } from '@nestjs/common';
import { BotConfigService } from '../config/bot-config.service';
import { ConfigLoaderService } from '../config/config-loader.service';

export interface TrelloBoard {
  id: string;
  name: string;
}

export interface TrelloList {
  id: string;
  name: string;
  idBoard: string;
}

export interface TrelloCard {
  id: string;
  name: string;
  url: string;
}

@Injectable()
export class TrelloService {
  private readonly logger = new Logger(TrelloService.name);
  private readonly baseUrl = 'https://api.trello.com/1';

  constructor(
    private readonly botConfig: BotConfigService,
    private readonly configLoader: ConfigLoaderService,
  ) {}

  get isEnabled(): boolean {
    return this.botConfig.trelloEnabled;
  }

  // ─── Card creation ────────────────────────────────────────────

  /**
   * Creates a card in a Trello list.
   * @param listKey - Key from bot.config.json trello.lists (e.g. "bugs")
   * @param title - Card title (supports {variable} interpolation already applied)
   * @param description - Card description (supports {variable} interpolation already applied)
   */
  async createCard(listKey: string, title: string, description: string): Promise<TrelloCard | null> {
    if (!this.isEnabled) {
      this.logger.warn('Trello is not enabled — skipping card creation');
      return null;
    }

    const { trello } = this.configLoader.botConfig;
    if (!trello) return null;

    const listId = trello.lists[listKey];
    if (!listId) {
      this.logger.error(`Trello list key "${listKey}" not found in bot.config.json trello.lists`);
      return null;
    }

    try {
      const url = `${this.baseUrl}/cards`;
      const params = new URLSearchParams({
        key: this.botConfig.trelloApiKey,
        token: this.botConfig.trelloToken,
        idList: listId,
        name: title,
        desc: description,
      });

      const response = await fetch(`${url}?${params.toString()}`, { method: 'POST' });

      if (!response.ok) {
        const body = await response.text();
        this.logger.error(`Trello API error ${response.status}: ${body}`);
        return null;
      }

      const card = await response.json() as TrelloCard;
      this.logger.log(`Trello card created: "${title}" → ${card.url}`);
      return card;
    } catch (error) {
      this.logger.error(`Failed to create Trello card: ${(error as Error).message}`);
      return null;
    }
  }

  // ─── Discovery (for !trello command) ─────────────────────────

  /** Returns all boards accessible by the configured token */
  async getBoards(): Promise<TrelloBoard[]> {
    try {
      const params = new URLSearchParams({
        key: this.botConfig.trelloApiKey,
        token: this.botConfig.trelloToken,
        fields: 'id,name',
      });

      const response = await fetch(`${this.baseUrl}/members/me/boards?${params.toString()}`);
      if (!response.ok) {
        this.logger.error(`Trello getBoards error ${response.status}`);
        return [];
      }
      return await response.json() as TrelloBoard[];
    } catch (error) {
      this.logger.error(`Failed to fetch Trello boards: ${(error as Error).message}`);
      return [];
    }
  }

  /** Returns all lists in a given board */
  async getListsForBoard(boardId: string): Promise<TrelloList[]> {
    try {
      const params = new URLSearchParams({
        key: this.botConfig.trelloApiKey,
        token: this.botConfig.trelloToken,
        fields: 'id,name,idBoard',
      });

      const response = await fetch(`${this.baseUrl}/boards/${boardId}/lists?${params.toString()}`);
      if (!response.ok) {
        this.logger.error(`Trello getLists error ${response.status}`);
        return [];
      }
      return await response.json() as TrelloList[];
    } catch (error) {
      this.logger.error(`Failed to fetch Trello lists: ${(error as Error).message}`);
      return [];
    }
  }
}
