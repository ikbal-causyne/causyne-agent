import rawInquirer from 'inquirer';


const inquirer = rawInquirer?.prompt
  ? rawInquirer
  : (rawInquirer?.default?.prompt
    ? rawInquirer.default
    : (rawInquirer?.default?.default?.prompt
      ? rawInquirer.default.default
      : rawInquirer));

export default inquirer;
