import { parseNseEquityCsv } from '../marketdata';

const HEADER = 'instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange';

describe('parseNseEquityCsv', () => {
  it('keeps only NSE cash equities and appends .NS', () => {
    const csv = [
      HEADER,
      '408065,1594,INFY,Infosys Ltd,0,,0,0.05,1,EQ,NSE,NSE',
      '2953217,11536,TCS,Tata Consultancy Services,0,,0,0.05,1,EQ,NSE,NSE',
    ].join('\n');
    const r = parseNseEquityCsv(csv);
    expect(r).toEqual([
      { symbol: 'INFY.NS', name: 'Infosys Ltd' },
      { symbol: 'TCS.NS', name: 'Tata Consultancy Services' },
    ]);
  });

  it('excludes non-EQ / non-NSE rows (futures, indices)', () => {
    const csv = [
      HEADER,
      '12345,123,SOMEFUT,Some Future,0,2026-01-01,0,0.05,1,FUT,NFO-FUT,NFO',
      '256265,0,NIFTY 50,NIFTY 50,0,,0,0,0,EQ,INDICES,NSE',
      '408065,1594,INFY,Infosys Ltd,0,,0,0.05,1,EQ,NSE,NSE',
    ].join('\n');
    expect(parseNseEquityCsv(csv).map((e) => e.symbol)).toEqual(['INFY.NS']);
  });

  it('handles unquoted names containing commas via trailing-column parse', () => {
    const csv = [HEADER, '99999,999,ACME,Acme, Industries Ltd,0,,0,0.05,1,EQ,NSE,NSE'].join('\n');
    expect(parseNseEquityCsv(csv)).toEqual([{ symbol: 'ACME.NS', name: 'Acme, Industries Ltd' }]);
  });

  it('skips tickers with spaces/odd characters', () => {
    const csv = [HEADER, '256265,0,NIFTY 50,NIFTY 50,0,,0,0,0,EQ,NSE,NSE'].join('\n');
    expect(parseNseEquityCsv(csv)).toEqual([]);
  });
});
