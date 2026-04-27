import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export const WHATSAPP_TOOLS: Tool[] = [
  {
    name: 'wa_send_message',
    description: 'Envia un mensaje de texto a un numero de WhatsApp.',
    inputSchema: {
      type: 'object',
      properties: {
        phone: {
          type: 'string',
          description: 'Numero en formato internacional sin + ni espacios (ej: 5493874063810)',
        },
        text: {
          type: 'string',
          description: 'Texto del mensaje a enviar. Soporta formato WhatsApp (*negrita*, _cursiva_).',
        },
      },
      required: ['phone', 'text'],
    },
  },
  {
    name: 'wa_send_to_group',
    description: 'Envia un mensaje de texto a un grupo de WhatsApp.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: {
          type: 'string',
          description: 'ID del grupo (formato: 120363XXXXXXXXX@g.us)',
        },
        text: {
          type: 'string',
          description: 'Texto del mensaje a enviar al grupo.',
        },
      },
      required: ['group_id', 'text'],
    },
  },
  {
    name: 'wa_get_chats',
    description: 'Lista todas las conversaciones activas (individuales y grupos).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximo de chats a devolver (default: 20, max: 100)',
        },
        type: {
          type: 'string',
          enum: ['all', 'individual', 'group'],
          description: 'Filtrar por tipo de chat',
        },
      },
    },
  },
  {
    name: 'wa_get_messages',
    description: 'Lee los mensajes de una conversacion.',
    inputSchema: {
      type: 'object',
      properties: {
        phone: {
          type: 'string',
          description: 'Numero en formato internacional (ej: 5493874063810). Alternativa a chat_id.',
        },
        chat_id: {
          type: 'string',
          description: 'ID completo del chat (ej: 5493874063810@c.us o grupo@g.us). Alternativa a phone.',
        },
        limit: {
          type: 'number',
          description: 'Cantidad de mensajes a traer (default: 20, max: 100)',
        },
      },
    },
  },
  {
    name: 'wa_get_contact',
    description: 'Obtiene informacion de un contacto de WhatsApp.',
    inputSchema: {
      type: 'object',
      properties: {
        phone: {
          type: 'string',
          description: 'Numero en formato internacional (ej: 5493874063810)',
        },
      },
      required: ['phone'],
    },
  },
  {
    name: 'wa_get_groups',
    description: 'Lista todos los grupos en los que esta la cuenta.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'wa_get_group_participants',
    description: 'Lista los participantes de un grupo.',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: {
          type: 'string',
          description: 'ID del grupo (formato: XXXXXXXXX@g.us)',
        },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'wa_search_messages',
    description: 'Busca mensajes que contengan un texto en todas las conversaciones.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Texto a buscar en los mensajes',
        },
        limit: {
          type: 'number',
          description: 'Maximo de resultados (default: 20)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'wa_get_status',
    description: 'Devuelve el estado actual de la conexion de WhatsApp.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'wa_get_profile_info',
    description: 'Obtiene la informacion del perfil de la cuenta conectada.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'wa_mark_as_read',
    description: 'Marca como leidos los mensajes de una conversacion.',
    inputSchema: {
      type: 'object',
      properties: {
        phone: {
          type: 'string',
          description: 'Numero en formato internacional',
        },
        chat_id: {
          type: 'string',
          description: 'ID completo del chat. Alternativa a phone.',
        },
      },
    },
  },
  {
    name: 'wa_get_unread_chats',
    description: 'Lista las conversaciones que tienen mensajes no leidos.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximo de resultados (default: 20)',
        },
      },
    },
  },
  {
    name: 'wa_check_number_exists',
    description: 'Verifica si un numero de telefono tiene cuenta de WhatsApp.',
    inputSchema: {
      type: 'object',
      properties: {
        phone: {
          type: 'string',
          description: 'Numero en formato internacional (ej: 5493874063810)',
        },
      },
      required: ['phone'],
    },
  },
];
