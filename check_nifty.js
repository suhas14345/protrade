const https = require('https');

function fetch(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

async function checkNiftyToken() {
    console.log('Fetching NSE instruments...');
    try {
        const data = await fetch('https://api.kite.trade/instruments/NSE');
        const lines = data.split('\n');
        console.log('Total instruments:', lines.length);
        
        const niftyIndices = lines.filter(l => l.includes('NIFTY 50'));
        console.log('NIFTY 50 matches:');
        niftyIndices.forEach(l => console.log(l));
        
        const indices = lines.filter(l => l.includes(',INDICES,'));
        console.log('\nSome INDICES:');
        indices.slice(0, 10).forEach(l => console.log(l));
    } catch (err) {
        console.error('Error:', err);
    }
}

checkNiftyToken();
