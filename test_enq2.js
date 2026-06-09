const { MultiSelect } = require('enquirer');

async function test() {
  const choices = [];
  for (let i = 0; i < 50; i++) {
    choices.push({
      name: String(i),
      message: `Chapter ${i + 1}`
    });
  }
  
  try {
    const prompt = new MultiSelect({
      name: 'chapters',
      message: 'Chọn chapter:',
      choices,
      limit: 15
    });
    // Let's just log what the choices look like internally
    console.log(prompt.choices.length);
  } catch(e) {
    console.error(e);
  }
}

test();
