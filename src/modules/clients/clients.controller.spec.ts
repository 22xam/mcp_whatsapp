import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';

describe('ClientsController — pagination', () => {
  let controller: ClientsController;
  let mockService: { search: jest.Mock };

  const fakeClients = Array.from({ length: 120 }, (_, i) => ({
    phone: `549${String(i).padStart(10, '0')}`,
    name: `Cliente ${i}`,
    company: 'ACME',
    systems: [],
    tags: [],
  }));

  beforeEach(() => {
    mockService = { search: jest.fn().mockReturnValue(fakeClients) };
    controller = new ClientsController(mockService as unknown as ClientsService);
  });

  it('returns a flat array when no pagination params are sent (backward compat)', () => {
    const result = controller.findAll();
    expect(Array.isArray(result)).toBe(true);
    expect((result as any[]).length).toBe(120);
  });

  it('returns paginated envelope when limit and offset are provided', () => {
    const result = controller.findAll(undefined, undefined, undefined, '50', '0') as any;
    expect(result).toMatchObject({ total: 120, limit: 50, offset: 0 });
    expect(result.data).toHaveLength(50);
  });

  it('returns correct slice for page 2', () => {
    const result = controller.findAll(undefined, undefined, undefined, '50', '50') as any;
    expect(result.offset).toBe(50);
    expect(result.data[0]).toMatchObject({ name: 'Cliente 50' });
    expect(result.data).toHaveLength(50);
  });

  it('clamps limit to 500 maximum', () => {
    const result = controller.findAll(undefined, undefined, undefined, '999', '0') as any;
    expect(result.limit).toBe(500);
    expect(result.data).toHaveLength(120);
  });

  it('returns empty data when offset is past the end', () => {
    const result = controller.findAll(undefined, undefined, undefined, '50', '200') as any;
    expect(result.total).toBe(120);
    expect(result.data).toHaveLength(0);
  });

  it('returns paginated envelope when only limit is provided', () => {
    const result = controller.findAll(undefined, undefined, undefined, '10') as any;
    expect(result).toMatchObject({ total: 120, limit: 10, offset: 0 });
    expect(result.data).toHaveLength(10);
  });
});
