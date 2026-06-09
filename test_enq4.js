const { MultiSelect } = require('enquirer');

async function test() {
  const choices = [];
  for (let i = 0; i < 5; i++) {
    choices.push({
      name: String(i),
      message: `Chapter ${i + 1}`,
      disabled: 'Đã tải'
    });
  }
  
  try {
    const prompt = new MultiSelect({
      name: 'chapters',
      message: 'Chọn chapter:',
      choices,
      limit: 15
    });
    const res = await prompt.run();
    console.log("Res:", res);
  } catch(e) {
    console.error("Error thrown:", e.message);
  }
}

test();
