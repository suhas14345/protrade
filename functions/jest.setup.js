// Pin strategy flags to the legacy multi-strategy path so tests are deterministic
// regardless of the production defaults (SEPA_ONLY/METALS now default ON in runtime.ts).
process.env.SEPA_ONLY = '0';
process.env.METALS = '0';

const mockFirestore = {
  settings: jest.fn(),
  collection: jest.fn().mockReturnThis(),
  doc: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  get: jest.fn().mockResolvedValue({ 
    exists: false, 
    empty: true, 
    size: 0, 
    docs: [],
    data: () => ({})
  }),
  set: jest.fn().mockResolvedValue(true),
  create: jest.fn().mockResolvedValue(true),
  update: jest.fn().mockResolvedValue(true),
  batch: jest.fn(() => ({
    set: jest.fn(),
    commit: jest.fn()
  }))
};

const firestoreMockNamespace = Object.assign(jest.fn(() => mockFirestore), {
  Timestamp: {
    now: jest.fn(() => ({ 
      toMillis: () => Date.now(),
      toDate: () => new Date()
    })),
    fromDate: jest.fn(d => d),
  },
  FieldPath: {
    documentId: jest.fn(() => '__name__'),
  }
});

jest.mock('firebase-admin', () => ({
  apps: [],
  initializeApp: jest.fn(),
  firestore: firestoreMockNamespace,
  storage: jest.fn(() => ({
    bucket: jest.fn()
  }))
}));

global.mockFirestore = mockFirestore;
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
